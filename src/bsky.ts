import { AtpAgentLoginOpts, BlobRef, BskyAgent } from "@atproto/api";
import fs from "node:fs";
import os from "node:os";
import { Command } from "commander";
import process, { exit } from "node:process";
import path from "node:path";
import mime from "mime";

type PostRef = { uri: string, cid: string }
type LocationInfo = { post_info: PostRef, thread_root: PostRef }

const configDir = os.homedir() + "/.bsky-cli";
const historyLocation = configDir + '/history.json'
const authLocation = configDir + "/auth.json";

function load_auth(): AtpAgentLoginOpts {
    console.log("loading auth")
    const fileContents = fs.readFileSync(authLocation, "utf-8");
    return JSON.parse(fileContents);
}

function load_history(): LocationInfo {
    console.log("loading history")
    const fileContents = fs.readFileSync(historyLocation, "utf-8");
    return JSON.parse(fileContents);
}

// upload images blobs and return the, uh, idk what to call it. app.bsky.embed.image record?
async function image_embed(images: string[]) {
  const blobs: BlobRef[] = [] //ew
  for (const image of images) {
    // strip image metadata
    // check that image is valid, try to resize if not

    // post image blob
    const mimetype = mime.getType(path.basename(image))
    if (mimetype === null) {
      exit("mimetype not found for " + image + ". check that it has an image extension")
    }

    const blob_resp = await agent.uploadBlob(fs.readFileSync(image), { encoding: mimetype })
    blobs.push(blob_resp.data.blob)
  }

  return {
    $type: "app.bsky.embed.images",
    images: blobs.map((blob) => { return {image: blob, alt: ""}})
  }
}

function quote_embed(quoting: PostRef) {
  return {
      $type: "app.bsky.embed.record",
      record: quoting
  }
}

interface PostData {
    text: string,
    replying_to?: LocationInfo,
    quoting?: PostRef,
    images?: string[]
}
async function makePost({text, replying_to, quoting, images}: PostData): Promise<void> {
    // compose post record
    const post_record: any = {
        text: text,
        createdAt: new Date().toISOString(),
    } // we can apparently use "{defn} as {typedef}" here and include types. im taking the lazy route.

    if (replying_to !== undefined) {
        post_record.reply = {
            root: replying_to.thread_root,
            parent: replying_to.post_info
        }
    }

    const image_post = images !== undefined && images.length > 0

    if (quoting !== undefined && image_post) {
      post_record.embed = {
        $type: "app.bsky.embed.recordWithMedia",
        record: quote_embed(quoting),
        media: await image_embed(images)
      }
    } else if (quoting !== undefined) {
      post_record.embed = quote_embed(quoting)
    } else if (image_post) {
      post_record.embed = await image_embed(images)
    }

    // post
    let result = await agent.post(post_record);

    // make data for saving
    result = { uri: result.uri, cid: result.cid }
    const post_info: LocationInfo = {
        post_info: result,
        thread_root: replying_to !== undefined ? replying_to.thread_root : result
    }

    // save post to history file
    fs.writeFileSync(historyLocation, JSON.stringify(post_info))
}


const agent = new BskyAgent({
  service: "https://bsky.social",
});

await agent.login(load_auth());


const program = new Command()
program
    .version('1.0.0')
    .description('A CLI tool for creating posts');

function collect(value: string, previous: string[]): string[] {
    return previous.concat([value])
}

program
    .command('post <text...>')
    .description('Create a new post')
    .option('-i, --image <path>', "path of image to upload", collect, [])
    .action((text, options) => {
      const postData: PostData = {
        text: text.join(' '),
        images: options.image,
      };
      makePost(postData);
    });

program
    .command('append <text...>')
    .description('reply to the last created post')
    .option('-i, --image <path>', "path of image to upload", collect, [])
    .action((text, options) => {
      const postData: PostData = {
        text: text.join(' '),
        replying_to: load_history(),
        images: options.image,
      };
      makePost(postData);
    });

program
    .command('quote <text...>')
    .description('quote the last created post')
    .option('-i, --image <path>', "path of image to upload", collect, [])
    .action((text, options) => {
      const postData: PostData = {
        text: text.join(' '),
        quoting: load_history().post_info,
        images: options.image,
      };
      makePost(postData);
    });

program.parse(process.argv);

// If no command is provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}

//*/
