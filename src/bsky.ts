import fs from "node:fs";
import os from "node:os";
import path from "node:path"
import process from "node:process";
import { exec } from 'node:child_process';
import { Buffer } from "node:buffer";
import { isText } from 'npm:istextorbinary';
import { fileTypeFromBuffer } from 'npm:file-type'
import {
  BlobRef,
  AtpAgent,
  AppBskyFeedPost,
  AppBskyEmbedImages,
  AppBskyEmbedRecord,
  AppBskyEmbedRecordWithMedia,
} from "@atproto/api";
import { Command } from "npm:commander";
import enquirer from "npm:enquirer";
const { prompt } = enquirer;

/* ------------------------------------------------------------ */

function exit(msg: string): never {
  console.log(msg);
  process.exit(-1);
}

function exhaustive_match(_: never): never {
  return _
}

function readJson<T>(path: string): T {
  return JSON.parse(fs.readFileSync(path, 'utf-8'))
}
function writeJson<T>(path: string, value:T): void {
  fs.writeFileSync(path, JSON.stringify(value))
}

/* ------------------------------------------------------------ */

const configFile =
  (os.type() == 'Windows_NT')
  ? path.join(os.homedir(), "AppData", "Roaming", ".bsky-cli.json")
  : path.join(os.homedir(), ".bsky-cli")

type AccountInfo = { handle: string, did: string, password: string };

type BskyConfig = {
  auth: AccountInfo,
  history?: LocationInfo
}

type BskyObjects = {
  agent: AtpAgent
}

type Bsky = BskyConfig & BskyObjects

function load_config(): BskyConfig {
  return readJson(configFile)
}

function write_config({auth, history}: BskyConfig): void {
  const config: BskyConfig = { auth: auth, history: history}
  return writeJson(configFile, config)
}

/* ------------------------------------------------------------ */


async function bsky_login(account: AccountInfo): Promise<[AtpAgent, AccountInfo]> {
  // login to bsky
  const agent = new AtpAgent({
    service: "https://bsky.social",
  });
  const res = await agent.login({ identifier: account.did, password: account.password });

  return [agent, { ...account, handle: res.data.handle }]
}

async function ask_new_account(): Promise<AccountInfo> {
  const loginInfo = await prompt ([
    {
      type: 'input',
      name: 'identifier',
      message: 'username'
    },
    {
      type: 'password',
      name: 'password',
      message: 'password:'
    }
  ]) as { identifier: string, password: string }

  console.log("connecting to bluesky")

  try {
    const agent = new AtpAgent({
      service: "https://bsky.social",
    });
    const resp =  await agent.login(loginInfo);

    console.log("credentials confirmed")
    return { handle: resp.data.handle, did: resp.data.did, password: loginInfo.password }

  } catch {
    console.log('connection unsuccesful. you probably have an invalid username or password')
    const { again } = await prompt({
      type: 'confirm',
      name: 'again',
      message: 'try again?'
    }) as { again: boolean };

    if (!again) {
      process.exit(0)
    } else {
      return ask_new_account()
    }
  }
}

/* ------------------------------------------------------------ */

async function get_post_text(handle: string): Promise<string> {
  let texts = ""
  while(true) {
    const { text } = await prompt({
      type: 'text',
      name: 'text',
      message: handle
    }) as { text: string }

    // keep going iff the last character of the given line is an escape char
    if (text[text.length - 1] == '\\') {
      texts += text.slice(0, text.length - 1) + "\n"
    } else {
      texts += text
      break
    }
  }
  return texts
}

/* ------------------------------------------------------------ */

function read_command_to_buffer(cmd: string): Promise<Buffer> {
  return new Promise((resolve, _reject) => {
    exec(cmd, { encoding: 'buffer' }, (_err, stdout, _stderr) => {
      resolve(stdout)
    })
  })
}

function read_clipboard(): Promise<Buffer> {
  if (os.platform() == 'linux') {
    return (read_command_to_buffer('wl-paste'))
  } else {
    exit('pasting from the clipboard is not supported on your platform')
  }
}

async function get_image(): Promise<ImageData> {
  const clipboard_contents = await read_clipboard()

  let data: Buffer
  if (isText(null, clipboard_contents)) {
    const location = ('' + clipboard_contents).trim()
    if (!fs.existsSync(location)) { exit('no file in clipboard') }
    data = fs.readFileSync(location)
  } else {
    data = clipboard_contents
  }

  const filetype = await fileTypeFromBuffer(data)
  if (filetype == undefined) { exit("Couldn't detect mimetype from file in clipboard") }
  const mimetype = filetype.mime

  if (mimetype.split('/')[0] != 'image') { exit('File in clipboard does not have an image mimetype') }
  return { data, mimetype }
}

/* ------------------------------------------------------------ */

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

async function post(postData: PostData, { agent }: BskyObjects): Promise<LocationInfo> {
  const result = await makePost(postData, agent)

  // save post to history file
  return {
    post_info: result,
    thread_root:
      // thread root is the parent of the chain we're replying if there's a chain, us if not
      postData.reply_type == 'reply'
        ? postData.replying_to.thread_root
        : result,
  }
}

/* ------------------------------------------------------------ */

async function first_run() {
  // get user data first, so we don't make a file if logging in fails
  console.log("welcome! please enter your username/app password to get started")
  const account = await ask_new_account()

  writeJson<BskyConfig>(configFile, {
    auth: account
  })
}

const needsFirstRun = !fs.existsSync(configFile)
async function run_initial_setup_if_needed() {
  if (needsFirstRun)
    await first_run()
}

const program = new Command();
program
  .version("0.1")
  .description("A CLI tool for creating posts");

function makeCommand(
  name: string,
  description: string,
  reply_info: (config: BskyConfig) => ReplyData,
) {
  program
    .command(`${name}`)
    .description(description)
    .option("--paste", "attach an image stored in the clipboard")
    .option("--dry-run", "print generated post instead of posting it")
    .action(async (options) => {
      await run_initial_setup_if_needed()
      const config = load_config()
      const session = bsky_login(config.auth)

      // if --paste is called, copy an image from the clipboard
      // we do it right at the start, so it'll hopefully be less likely to catch fake data
      let image: Promise<ImageData>
      if (options.paste) {
        image = get_image()
      }

      const text = await get_post_text(config.auth.handle)

      // prevent the user from uploading blank strings
      if (text.trim() == '') {
        process.exit(0)
      }

      let media_info: MediaData
      if (options.paste) {
        media_info = { media_type: 'image', images: [await image!] }
      } else {
        media_info = { media_type: 'no-media' }
      }

      const [agent, { handle }] = await session
      // update handle in order to keep the prompt in check
      config.auth.handle = handle

      const postObject =
        {
          text,
          ...media_info,
          ...reply_info(config)
        }

      if (options.dryRun) {
        console.log(postObject)
        process.exit(0)
      }

      const lastPost = await post(postObject, { agent });
      write_config({ ...config, history: lastPost})
      process.exit(0)
    })
}

function require_history(history: LocationInfo | undefined): LocationInfo {
  if (history == undefined)
    exit("you're trying to quote/reply to the latest post but you haven't made a post yet")
  return history
}

makeCommand("post", "create a new post", () => ({ reply_type: 'no-parent' }));
makeCommand(
  "append",
  "reply to the last created post",
  ({ history }) => (
      { reply_type: 'reply'
      , replying_to: require_history(history)
      }),
);
makeCommand(
  "quote",
  "quote the last created post",
  ({ history }) => (
      { reply_type: 'quote'
      , quoting: require_history(history).post_info
      }),
);

program
  .command('init')
  .description('log in to an account')
  .action(async () => {
    if (!needsFirstRun) {
      exit("account already setup.\n if you want to reset the program, remove ~/.bsky-cli and call `bsky init` again")
    }

    await first_run()
    process.exit(0)
  })

await program.parseAsync(process.argv);

// If no command is provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
