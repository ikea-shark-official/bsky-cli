import { AtpAgent } from "@atproto/api";
import fs from "node:fs";
import os from "node:os";
import { Argument, Command } from "commander";
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

const configFile = os.homedir() + "/.bsky-cli";

type AccountInfo = { handle: string, did: string, password: string };
type AuthStatus = { currentDid: string, lastAccountDid?: string } // stored in account_status.json

type AuthInfo = { accounts: AccountInfo[] } & AuthStatus

type BskyConfig = {
  auth: AuthInfo,
  history?: LocationInfo
}

function get_handle_by_did({accounts}: AuthInfo, did: string) {
  return accounts.filter((a) => (a.did == did))[0].handle
}
function get_did_by_handle({accounts}: AuthInfo, handle: string) {
  return accounts.filter((a) => (a.handle == handle))[0].did
}

function get_active_account({accounts, currentDid}: AuthInfo): AccountInfo {
  return accounts.filter((a) => (a.did == currentDid))[0];
}

function load_config(): BskyConfig {
  return readJson(configFile)
}

function write_config({auth, history}: BskyConfig): void {
  const config: BskyConfig = { auth: auth, history: history}
  return writeJson(configFile, config)
}

/* ------------------------------------------------------------ */

async function select_account_dialog(auth: AuthInfo, message: string): Promise<AccountInfo> {
  const { removing } = await prompt({
    type: 'select',
    choices: auth.accounts.map((acc) => (acc.handle)),
    initial: 0,
    name: 'removing',
    message: message
  }) as { removing: string }

  return auth.accounts.filter(acc => acc.handle == removing)[0]
}

async function change_active_account(auth: AuthInfo): Promise<AuthInfo> {
  const prev: AuthStatus = auth

  const nextAccount = await select_account_dialog(auth, "select new account")

  const next: AuthStatus = { currentDid: nextAccount.did };

  if (next.currentDid == prev.currentDid) {
    exit("you are already using " + nextAccount.handle);
  }

  const dids: string[] = auth.accounts.map((acc) => (acc.did))
  if (!dids.includes(next.currentDid)) {
    exit("given account name not found in auth.json")
  }

  next.lastAccountDid = prev.currentDid

  console.log(
    "switched account from " + get_handle_by_did(auth, prev.currentDid) +
                      " to " + get_handle_by_did(auth, next.currentDid)
  );
  return { accounts: auth.accounts, ...next }
}

// print active accounts to terminal, for `bsky accounts`
function list_accounts(auth: AuthInfo) {
  for (const account of auth.accounts) {
    console.log(account.handle)
  }
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

async function remove_account(auth: AuthInfo): Promise<AuthInfo> {
  const removing = (await select_account_dialog(auth, 'select account to remove'))

  const newAccounts = auth.accounts.filter((acc) => (acc.handle != removing.handle))

  console.log(`removed ${removing} from account list`)
  return { ...auth, accounts: newAccounts }
}

/* ------------------------------------------------------------ */

async function bsky_login(auth: AuthInfo): Promise<AtpAgent> {
  // login to bsky
  const agent = new AtpAgent({
    service: "https://bsky.social",
  });
  const account = get_active_account(auth)
  await agent.login({ identifier: account.did, password: account.password });

  return agent
}

async function post(postData: PostData, auth: AuthInfo): Promise<LocationInfo> {
  const agent = await bsky_login(auth)
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
    auth: {
      accounts: [account],
      currentDid: account.did
    }
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
        message: `${get_active_account(config.auth).handle}>`
      }) as { text: string };

      // prevent the user from uploading blank strings
      if (response.text.trim() == '') {
        process.exit(0)
      }

      const baseData: PostData = {
        text: response.text ,
      };

      await post({ ...baseData, ...extraData(config) }, config.auth);
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
  .command("switch [account]")
  .description("switch to the named account, or the last one used if unspecified")
  .action(async () => {
    await run_initial_setup_if_needed()
    let { auth, history } = load_config()
    auth = await change_active_account(auth)
    write_config( { auth, history })
  });

program
  .command('accounts')
  .addArgument(new Argument('[command]').choices(['add', 'remove']))
  .description("list accounts, or add/remove with 'accounts [add/remove]'")
  .action(async (command) => {
    let { auth, history } = load_config()

    if (command == undefined) {
      await run_initial_setup_if_needed()
      list_accounts(auth)

    } else if (command == 'add') {
      if (needsFirstRun)
        return (first_run())

      const account = await ask_new_account()
      auth.accounts.push(account)
      write_config({ auth, history })

    } else if (command == 'remove') {
      await run_initial_setup_if_needed()
      auth = await remove_account(auth)
      write_config({ auth, history })
    }
  })

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
