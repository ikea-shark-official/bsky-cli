import fs from "node:fs";
import os from "node:os";
import path from "node:path"
import process from "node:process";
import { exec } from 'node:child_process';
import { Buffer } from "node:buffer";
import { AtpAgent } from "npm:@atproto/api";
import { Command } from "npm:commander";
import enquirer from "npm:enquirer";
const { prompt } = enquirer;
// import { fileTypeFromBuffer } from "npm:file-type"

import { exhaustive_match, exit } from "./common.ts";
import { LocationInfo, PostData, ImageData, makePost } from "./post.ts";


/* ------------------------------------------------------------ */

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

async function ask_for_images(): Promise<ImageData[]> {
  const images: ImageData[] = []
  // TODO: get initial image confirmation
  while (true) {
    // get file/determine mimetype
    const data = await read_clipboard()
    const mimetype = 'image/png'
    images.push({ data, mimetype })

    // ask if we want to go again, return images if not
    const { repeat } = await prompt({
      type: 'confirm',
      name: 'repeat',
      message: "Do you want to add another?",
    }) as { repeat: boolean }

    if (!repeat || images.length >= 4)
      return images
  }
}

/* ------------------------------------------------------------ */

async function post(postData: PostData, { agent }: BskyObjects): Promise<LocationInfo> {
  const result = await makePost(postData, agent)

  // save post to history file
  return {
    post_info: result,
    thread_root:
      // thread root is the parent of the chain we're replying if there's a chain, us if not
      postData.replying_to !== undefined
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
  extraData: (config: BskyConfig) => Partial<PostData>,
) {
  program
    .command(`${name}`)
    .description(description)
    .option("-i, --attach-image", "attach one or more images")
    .action(async (options) => {
      await run_initial_setup_if_needed()
      const config = load_config()
      const session = bsky_login(config.auth)

      const response = await prompt({
        type: 'input',
        name: 'text',
        message: `${config.auth.handle}>`
      }) as { text: string };

      // prevent the user from uploading blank strings
      if (response.text.trim() == '') {
        process.exit(0)
      }

      const images: ImageData[] | undefined =
        options.attachImage
        ? await ask_for_images()
        : undefined

      const baseData: PostData = {
        text: response.text,
        images: images
      };

      const [agent, { handle }] = await session
      config.auth.handle = handle

      const lastPost = await post({ ...baseData, ...extraData(config) }, { agent });
      write_config({ ...config, history: lastPost})
      process.exit(0)
    })
}

function require_history(history: LocationInfo | undefined): LocationInfo {
  if (history == undefined)
    exit("you're trying to quote/reply to the latest post but you haven't made a post yet")
  return history
}

makeCommand("post", "create a new post", () => ({}));
makeCommand(
  "append",
  "reply to the last created post",
  ({ history }) => ({ replying_to: require_history(history) }),
);
makeCommand(
  "quote",
  "quote the last created post",
  ({ history }) => ({ quoting: require_history(history).post_info }),
);

program
  .command('init')
  .description('log in to an account')
  .action(() => {
    if (!needsFirstRun) {
      exit("account already setup.\n if you want to reset the program, remove ~/.bsky-cli and call `bsky init` again")
    }

    first_run()
    process.exit(0)
  })

await program.parseAsync(process.argv);

// If no command is provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
