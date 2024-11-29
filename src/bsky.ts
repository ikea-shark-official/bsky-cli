import { AtpAgent } from "@atproto/api";
import fs from "node:fs";
import os from "node:os";
import path from "node:path"
import { Command } from "commander";
import process from "node:process";
import enquirer from "enquirer";
const { prompt } = enquirer;

import { exit } from "./common.ts";
import { LocationInfo, PostData, makePost } from "./post.ts";


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
      type: 'invisible',
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

async function post(postData: PostData, auth: AccountInfo): Promise<LocationInfo> {
  const [agent, _] = await bsky_login(auth)
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
  console.log("welcome to bluesky-cli! please enter your username/app password to get started")
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
    // .option("-i, --image <path>", "path of image to upload", collect, [])
    .action(async (_options) => {
      await run_initial_setup_if_needed()
      const config = load_config()

      const response = await prompt({
        type: 'input',
        name: 'text',
        message: `${config.auth.handle}>`
      }) as { text: string };

      // prevent the user from uploading blank strings
      if (response.text.trim() == '') {
        process.exit(0)
      }

      const baseData: PostData = {
        text: response.text ,
      };

      const lastPost = await post({ ...baseData, ...extraData(config) }, config.auth);
      write_config({ ...config, history: lastPost})
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

    return first_run()
  })

await program.parseAsync(process.argv);

// If no command is provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
