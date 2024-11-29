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
export { type PostRef, type LocationInfo, type PostData, type ImageData, makePost}

type PostRef = { uri: string; cid: string };
type LocationInfo = { post_info: PostRef; thread_root: PostRef };

type ImageData = { data: Buffer, mimetype: string }

// upload images blobs and return the image embed record
async function image_embed(images: ImageData[], agent: AtpAgent): Promise<AppBskyEmbedImages.Main> {
  const blobs: BlobRef[] = [];
  for (const { data, mimetype } of images) {
    // strip image metadata
    // check that image is valid, try to resize if not

    // post image blob
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

interface PostData {
  text: string;
  replying_to?: LocationInfo;
  quoting?: PostRef;
  images?: ImageData[];
}
async function makePost(
  { text, replying_to, quoting, images }: PostData,
  agent: AtpAgent
): Promise<PostRef> {
  // compose post record
  const post_record: AppBskyFeedPost.Record = {
    text: text,
    createdAt: new Date().toISOString(),
  };

  if (replying_to !== undefined) {
    post_record.reply = {
      root: replying_to.thread_root,
      parent: replying_to.post_info,
    };
  }

  const image_post = images !== undefined && images.length > 0;

  if (quoting !== undefined && image_post) {
    post_record.embed = {
      $type: "app.bsky.embed.recordWithMedia",
      record: quote_embed(quoting),
      media: await image_embed(images, agent),
    } as AppBskyEmbedRecordWithMedia.Main ;
  } else if (quoting !== undefined) {
    post_record.embed = quote_embed(quoting);
  } else if (image_post) {
    post_record.embed = await image_embed(images, agent);
  }

  // post
  const validationResult = AppBskyFeedPost.validateRecord(post_record)
  if (!validationResult.success) {
    exit("post record validation failed: " + validationResult.error)
  }

  return agent.post(post_record);
}
