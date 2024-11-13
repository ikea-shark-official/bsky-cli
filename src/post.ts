import {
  BlobRef,
  AtpAgent,
  AppBskyFeedPost,
  AppBskyEmbedImages,
  AppBskyEmbedRecord,
  AppBskyEmbedRecordWithMedia,
} from "@atproto/api";
import mime from "mime";
import path from "node:path";
import fs from "node:fs";
import { exit } from './common.ts';
export { type PostRef, type LocationInfo, type PostData, makePost}

type PostRef = { uri: string; cid: string };
type LocationInfo = { post_info: PostRef; thread_root: PostRef };

// upload images blobs and return the, uh, idk what to call it. app.bsky.embed.image record?
async function image_embed(images: string[], agent: AtpAgent): Promise<AppBskyEmbedImages.Main> {
  const blobs: BlobRef[] = []; //ew
  for (const image of images) {
    // check that image mimetype is valid
    const mimetype = mime.getType(path.basename(image));
    if (mimetype === null) {
      exit("mimetype not found for " + image + ". check that it has an image extension");
    } else if (mimetype.split("/")[0] !== "image") {
      exit("invalid mimetype for an image post: " + mimetype);
    }
    // strip image metadata
    // check that image is valid, try to resize if not

    // post image blob
    const blob_resp = await agent.uploadBlob(fs.readFileSync(image), { encoding: mimetype });
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
  images?: string[];
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
