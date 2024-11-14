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

const configDir = os.homedir() + "/.bsky-cli";
const historyLocation = configDir + "/post_history.json";
const authLocation = configDir + "/auth.json";
const authStatusLocation = configDir + "/account_status.json"

type AccountInfo = { handle: string, did: string, password: string };
type AuthStatus = { currentDid: string, lastAccountDid?: string } // stored in account_status.json

type AuthInfo = { accounts: AccountInfo[] } & AuthStatus

function get_handle_by_did({accounts}: AuthInfo, did: string) {
  return accounts.filter((a) => (a.did == did))[0].handle
}
function get_did_by_handle({accounts}: AuthInfo, handle: string) {
  return accounts.filter((a) => (a.handle == handle))[0].did
}

function get_active_account({accounts, currentDid}: AuthInfo): AccountInfo {
  return accounts.filter((a) => (a.did == currentDid))[0];
}

function load_history(): LocationInfo {
  return readJson(historyLocation)
}

function write_history(history: LocationInfo): void {
  writeJson(historyLocation, history)
}

function load_auth(): AuthInfo {
  const authInfo: AccountInfo[] = readJson(authLocation)
  const authStatus: AuthStatus = readJson(authStatusLocation)
  return { accounts: authInfo, ...authStatus }
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

async function change_active_account() {
  const authInfo = load_auth()
  const prev: AuthStatus = authInfo

  const nextAccount = await select_account_dialog(authInfo, "select new account")

  const next: AuthStatus = { currentDid: nextAccount.did };

  if (next.currentDid == prev.currentDid) {
    exit("you are already using " + nextAccount.handle);
  }

  const dids: string[] = authInfo.accounts.map((acc) => (acc.did))
  if (!dids.includes(next.currentDid)) {
    exit("given account name not found in auth.json")
  }

  next.lastAccountDid = prev.currentDid

  writeJson(authStatusLocation, next as AuthStatus)
  console.log(
    "switched account from " + get_handle_by_did(authInfo, prev.currentDid) +
                      " to " + get_handle_by_did(authInfo, next.currentDid)
  );
}

// print active accounts to terminal, for `bsky accounts`
function list_accounts() {
  for (const account of load_auth().accounts) {
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

/** Add the given account to auth.json, creating the file if it doesn't exist */
function add_account(account: AccountInfo): void {
  let accounts: AccountInfo[]
  if (!fs.existsSync(authLocation)) {
    accounts = []
  } else {
    ({ accounts } = load_auth())
  }

  accounts.push(account)
  writeJson(authLocation, accounts)
}

async function remove_account() {
  const auth = load_auth()
  const removing = (await select_account_dialog(auth, 'select account to remove'))

  const newAccounts = auth.accounts.filter((acc) => (acc.handle != removing.handle))
  writeJson(authLocation, newAccounts)
  console.log(`removed ${removing} from account list`)
  process.exit(0)
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

async function post(postData: PostData, auth: AuthInfo){
  const agent = await bsky_login(auth)
  const result = await makePost(postData, agent)

  // save post to history file
  write_history({
    post_info: result,
    thread_root:
      // thread root is the parent of the chain we're replying if there's a chain, us if not
      postData.replying_to !== undefined
        ? postData.replying_to.thread_root
        : result,
  })
}

/* ------------------------------------------------------------ */

async function first_run() {
  // get user data first, so we don't make stuff if logging in fails
  const accountInfo = await ask_new_account()

  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(historyLocation, '') // history file is just empty
  add_account(accountInfo)
  const authStatus: AuthStatus = {
    currentDid: accountInfo.did
  }
  writeJson(authStatusLocation, authStatus)
  process.exit(0)
}

const configFiles = [configDir, authLocation, historyLocation, authStatusLocation]
if (!configFiles.every(fs.existsSync)) {
  first_run()
}


const program = new Command();
program
  .version("0.1.0")
  .description("A CLI tool for creating posts");

function makeCommand(
  name: string,
  description: string,
  extraData: () => Partial<PostData>,
) {
  program
    .command(`${name}`)
    .description(description)
    // .option("-i, --image <path>", "path of image to upload", collect, [])
    .action(async (_options) => {
      const auth = load_auth()

      const response = await prompt({
        type: 'input',
        name: 'text',
        message: `${get_active_account(auth).handle}>`
      }) as { text: string };

      // prevent the user from uploading blank strings
      if (response.text.trim() == '') {
        process.exit(0)
      }

      const baseData: PostData = {
        text: response.text ,
      };

      await post({ ...baseData, ...extraData() }, auth);
      process.exit(0) // TODO, is this the best way to handle this?
    })
}

makeCommand("post", "create a new post", () => ({}));
makeCommand(
  "append",
  "reply to the last created post",
  () => ({ replying_to: load_history() }),
);
makeCommand(
  "quote",
  "quote the last created post",
  () => ({ quoting: load_history().post_info }),
);

program
  .command("switch [account]")
  .description(
    "switch to the named account, or the last one used if unspecified",
  )
  .action(change_active_account);

program
  .command('accounts')
  .addArgument(new Argument('[command]').choices(['add', 'remove']))
  .description("list accounts, or add/remove with 'accounts [add/remove]'")
  .action(async (command) => {
    if (command == undefined) {
      list_accounts()
    } else if (command == 'add') {
      const account = await ask_new_account()
      add_account(account)
    } else if (command == 'remove') {
      remove_account()
    }
  })

program.parse(process.argv);

// If no command is provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
