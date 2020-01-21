'use strict';

const util = require('util');
const childProcess = require('child_process');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const aws = require('aws-sdk');

let s3_config = {
  apiVersion: '2006-03-01',
  s3ForcePathStyle: true
};

if (process.env.s3_endpoint) {
  s3_config['endpoint'] = process.env.s3_endpoint;
  s3_config['region'] = process.env.s3_region;
}
const s3 = new aws.S3(s3_config);

let sns_config = {
  apiVersion: '2010-03-31'
};

if (process.env.sns_endpoint) {
  sns_config['endpoint'] = process.env.sns_endpoint;
  sns_config['region'] = process.env.sns_region;
}
const sns = new aws.SNS(sns_config);

let exec = util.promisify(childProcess.exec);


const SNS_COMPLETE = 'thumbnail_complete';
const SNS_ERROR = 'thumbnail_error';

exports.handler = async (event, context, callback) => {

  console.log(s3_config);

  const bucket = event.Records[0].s3.bucket.name;
  const key = decodeURIComponent(
      event.Records[0].s3.object.key.replace(/\+/g, ' '));

  const fileName = path.basename(key);
  if (fileName.split('.').length != 2) {
    context.done('extension not found');
    return;
  }
  const contentId = fileName.split('.')[0];
  const extension = fileName.split('.')[1];

  const params = {
    Bucket: bucket,
    Key: key,
  };

  console.log('params', params);

  try {
    const data = await s3.getObject(params).promise();

    let contentType = data.ContentType;

    const copyKey = process.env.DEPLOY_PATH + '/'
        + contentId + '/'
        + 'origin.' + extension;

    if (['jpg', 'jpeg', 'png', 'bmp', 'gif'].includes(extension.toLowerCase())) {
      console.log('output image');

      let originData = data.Body;
      let imageBuffer;
      const image = await sharp(data.Body);
      if (['jpg', 'jpeg'].includes(extension.toLowerCase())) {
        await image.rotate();
        originData = imageBuffer = await image.toBuffer();
      } else {
        imageBuffer = await image.toBuffer();
      }

      try {
        await s3.putObject({
          Bucket: bucket,
          Key: copyKey,
          Body: originData,
          ContentType: contentType,
        }).promise();
      } catch (err) {
        console.log('copy object err', err);
        await sendSNS(SNS_ERROR, bucket, key);
        return;
      }

      await resizeAndPutObject(context, imageBuffer, bucket, key);

      console.log('output image end');
    } else if (extension.toLowerCase() == 'pdf') {
      console.log('output pdf');

      try {
        await s3.putObject({
          Bucket: bucket,
          Key: copyKey,
          Body: data.Body,
          ContentType: contentType,
        }).promise();
      } catch (err) {
        console.log('copy object err', err);
        await sendSNS(SNS_ERROR, bucket, key);
        return;
      }

      console.log('convert pdf to png');

      const tmpPath = '/tmp/convert.pdf';
      fs.writeFileSync(tmpPath, data.Body, 'binary');

      try {
        //amazon linux2からGhostScriptインストールされていない状態になったので、
        //GhostScriptの実行バイナリをlambdaに同梱して実行することにした
        const gsPath = __dirname + '/bin/gs';

        //PDFは１枚目をPNG変換して登録する
        await exec(
            gsPath + ' -dCompatibilityLevel=1.4 -dQUIET' +
            ' -dPARANOIDSAFER -dBATCH -dNOPAUSE -dNOPROMPT -sDEVICE=png16m' +
            ' -dTextAlphaBits=4 -dGraphicsAlphaBits=4 -r72 -dFirstPage=1' +
            ' -dLastPage=1 -sOutputFile=/tmp/pdf_1.png ' + tmpPath
        );
        await resizeAndPutObject(context, '/tmp/pdf_1.png', bucket, key);
      } catch (err) {
        console.log('pdf to png error', err);
        //png変換に失敗した場合はデフォルトアイコンをサムネイルにする
        await resizeAndPutObject(context, 'pdf.png', bucket, key);
      }
    } else {
      console.log('not target thumbnail creation', key);
    }
    console.log('end');
  } catch (err) {
    await sendSNS(SNS_ERROR, bucket, key);
    context.done('get object failed', err);
  }
};

/**
 * 画像データをリサイズしてs3に配置する
 *
 * @param  {Buffer|String} dataSrc     sharpでtoBuffer()したデータ or 対象画像ファイルパス
 * @param  {string} bucket      対象バケット名
 * @param  {string} key         対象ファイルs3 key
 */
async function resizeAndPutObject(
    context,
    dataSrc,
    bucket,
    key
) {


  const fileName = path.basename(key);
  const contentId = fileName.split('.')[0];
  let extension = fileName.split('.')[1];

  if (extension == 'pdf') {
    extension = 'png';
  }

  let image;
  try {
    image = await sharp(dataSrc)

    let width = 0;
    let height = 0;

    await image.metadata().
        then(meta => ([width, height] = [meta.width, meta.height]));

    console.log('width/height', [width, height]);

    if (Number(width) > Number(height)) {
      await image.resize(250);
    } else {
      await image.resize(null, 200);
    }
  } catch (err) {
    console.log(err);
    await sendSNS(SNS_ERROR, bucket, key);
    context.done('resize failed');
    return;
  }

  let thumbnailKey = process.env.DEPLOY_PATH + '/'
      + contentId + '/'
      + 'thumbnail.' + extension;

  try {
    let im = await image.toBuffer();
    await s3.putObject({
      Bucket: bucket,
      Key: thumbnailKey,
      Body: im
    }).promise();

    await sendSNS(SNS_COMPLETE, bucket, key);

  } catch (err) {
    console.log(err);
    await sendSNS(SNS_ERROR, bucket, key);
    context.done('error put object');
  }
}

/**
 * SNSへ通知を送る
 *
 * @param  {string} subject Topicタイトル
 * @param  {string} bucket  対象バケット名
 * @param  {string} key     対象ファイルKey
 */
async function sendSNS(subject, bucket, key) {
  try {
    const ret = await s3.deleteObject({
      Bucket: bucket,
      Key: key,
    }).promise();

    let topicArn;
    if (String(subject) === SNS_COMPLETE) {
      topicArn = process.env.TOPIC_ARN_SUCCESS;
    } else {
      topicArn = process.env.TOPIC_ARN_ERROR;
    }

    console.log('sns publish', key, subject, topicArn);
    try {
      await sns.publish({
        Message: key,
        Subject: subject,
        TopicArn: topicArn,
      }).promise();

      console.log('sns published.');
    } catch (err) {
      console.log('sns publish err', err);
    }
  } catch (err) {
    console.log('delete object failed', err);
  }
}
