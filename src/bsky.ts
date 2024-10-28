import {
  BlobRef,
  AtpAgent,
  AppBskyFeedPost,
  AppBskyEmbedImages,
  AppBskyEmbedRecord,
  AppBskyEmbedRecordWithMedia,
} from "@atproto/api";
import fs from "node:fs";
import os from "node:os";
import { Argument, Command } from "commander";
import process from "node:process";
import path from "node:path";
import mime from "mime";
import enquirer from "enquirer";
const { prompt } = enquirer;

function exit(msg: string): never {
  console.log(msg);
  process.exit(-1);
}

function readJson<T>(path: string): T {
  return JSON.parse(fs.readFileSync(path, 'utf-8'))
}
function writeJson<T>(path: string, value:T): void {
  fs.writeFileSync(path, JSON.stringify(value))
}


type PostRef = { uri: string; cid: string };
type LocationInfo = { post_info: PostRef; thread_root: PostRef };

const configDir = os.homedir() + "/.bsky-cli";
const historyLocation = configDir + "/post_history.json";
const authLocation = configDir + "/auth.json";
const authStatusLocation = configDir + "/account_status.json"

type AccountInfo = { handle: string, did: string, password: string };
type AuthStatus = { currentDid: string, lastAccountDid?: string } // stored in account_status.json

type AuthInfo = { accounts: AccountInfo[] } & AuthStatus

async function first_run() {
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(historyLocation, '') // history file is just empty

  const accountInfo = await add_account(true)
  const authStatus: AuthStatus = {
    currentDid: accountInfo.did
  }
  writeJson(authStatusLocation, authStatus)
  process.exit(0)
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

function load_auth(): AuthInfo {
  const authInfo: AccountInfo[] = readJson(authLocation)
  const authStatus: AuthStatus = readJson(authStatusLocation)
  return { accounts: authInfo, ...authStatus }
}

function change_active_account(newHandle: string | undefined) {
  const authInfo = load_auth()
  const prev: AuthStatus = authInfo

  // if the new handle is given, switch to that
  // otherwise, switch to the last account used
  // if that doesn't exist, quit with an error message
  var nextDid: string
  if (newHandle != undefined) {
    nextDid = get_did_by_handle(authInfo, newHandle)
  } else if (prev.lastAccountDid != undefined) {
    nextDid = prev.lastAccountDid
  } else {
    exit("`bsky switch` switches to the last account used but you don't seem to have a last account used.\n try switching to an account using its handle")
  }
  const next: AuthStatus = { currentDid: nextDid };

  if (next.currentDid == prev.currentDid) {
    exit("you are already using " + newHandle);
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

async function ask_account_info(allowCancel: boolean): Promise<AccountInfo> {
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
      return ask_account_info(allowCancel)
    }
  }
}

async function add_account(firstRun?: boolean): Promise<AccountInfo> {
  firstRun = (firstRun != undefined) ? firstRun : false

  // we don't want the user to be able to quit on the first run and fuck it up
  const allowExiting = firstRun? false : true
  const accountInfo = await ask_account_info(allowExiting)

  let accounts: AccountInfo[]
  if (firstRun) {
    accounts = []
  } else {
    ({ accounts } = load_auth())
  }

  accounts.push(accountInfo)
  writeJson(authLocation, accounts)
  if (firstRun) {
    return accountInfo
  } else {
    process.exit(0)
  }
}

async function remove_account() {
  const { accounts } = load_auth()
  const { removing } = await prompt({
    type: 'select',
    choices: accounts.map((acc) => (acc.handle)),
    initial: 0,
    name: 'removing',
    message: 'select account to remove'
  }) as { removing: string }

  const newAccounts = accounts.filter((acc) => (acc.handle != removing))
  writeJson(authLocation, newAccounts)
  console.log(`removed ${removing} from account list`)
  process.exit(0)
}

function load_history(): LocationInfo {
  return readJson(historyLocation)
}

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
  auth: AuthInfo
): Promise<void> {
  // login to bsky
  const agent = new AtpAgent({
    service: "https://bsky.social",
  });
  const account = get_active_account(auth)
  await agent.login({ identifier: account.did, password: account.password });

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

  let result = await agent.post(post_record);

  // make data for saving
  result = { uri: result.uri, cid: result.cid };
  const post_info: LocationInfo = {
    post_info: result,
    thread_root: replying_to !== undefined ? replying_to.thread_root : result,
  };

  // save post to history file
  writeJson(historyLocation, post_info)
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

      await makePost({ ...baseData, ...extraData() }, auth);
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
  .action((command) => {
    if (command == undefined) {
      list_accounts()
    } else if (command == 'add') {
      const configFiles = [configDir, authLocation, historyLocation, authStatusLocation]
      if (configFiles.every(fs.existsSync)) {
        add_account() // standard account adding procedure
      } else {
        first_run()
      }
    } else if (command == 'remove') {
      remove_account()
    }
  })

program.parse(process.argv);

// If no command is provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}

//*/
