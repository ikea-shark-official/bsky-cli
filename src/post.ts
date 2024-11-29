import {
  BlobRef,
  AtpAgent,
  AppBskyFeedPost,
  AppBskyEmbedImages,
  AppBskyEmbedRecord,
  AppBskyEmbedRecordWithMedia,
} from "@atproto/api";
import { Buffer } from "node:buffer";

import { exit } from './common.ts';
export { type PostRef, type LocationInfo, type PostData, type ImageData, type MediaData, type ReplyData, makePost}

type PostRef = { uri: string; cid: string };
type LocationInfo = { post_info: PostRef; thread_root: PostRef };

type ImageData = { data: Buffer, mimetype: string }

// upload image blobs and return an image embed record for them
async function image_embed(images: ImageData[], agent: AtpAgent): Promise<AppBskyEmbedImages.Main> {
  const blobs: BlobRef[] = [];
  for (const { data, mimetype } of images) {
    const blob_resp = await agent.uploadBlob(data, { encoding: mimetype });
    blobs.push(blob_resp.data.blob);
  }

  return {
    $type: "app.bsky.embed.images",
    images: blobs.map((blob) => {
      return { image: blob, alt: "" };
    }),
  };
}

function quote_embed(quoting: PostRef): AppBskyEmbedRecord.Main {
  return {
    $type: "app.bsky.embed.record",
    record: quoting,
  };
}

type MediaData =
  { media_type: 'no-media' } |
  { media_type: 'image', images: ImageData[] }
type ReplyData =
  { reply_type: 'no-parent' } |
  { reply_type: 'reply', replying_to: LocationInfo } |
  { reply_type: 'quote', quoting: PostRef }
type PostData = { text: string } & MediaData & ReplyData

async function makePost(
  post: PostData,
  agent: AtpAgent
): Promise<PostRef> {
  // compose post record
  const post_record: AppBskyFeedPost.Record = {
    text: post.text,
    createdAt: new Date().toISOString(),
  };

  if (post.reply_type == 'reply') {
    post_record.reply = {
      root: post.replying_to.thread_root,
      parent: post.replying_to.post_info,
    };
  }

  const image_post = post.media_type == 'image'  && post.images.length > 0;

  if (post.reply_type == 'quote' && image_post) {
    post_record.embed = {
      $type: "app.bsky.embed.recordWithMedia",
      record: quote_embed(post.quoting),
      media: await image_embed(post.images, agent),
    } as AppBskyEmbedRecordWithMedia.Main ;
  } else if (post.reply_type == 'quote') {
    post_record.embed = quote_embed(post.quoting);
  } else if (image_post) {
    post_record.embed = await image_embed(post.images, agent);
  }

  // post
  const validationResult = AppBskyFeedPost.validateRecord(post_record)
  if (!validationResult.success) {
    exit("post record validation failed: " + validationResult.error)
  }

  return agent.post(post_record);
}
