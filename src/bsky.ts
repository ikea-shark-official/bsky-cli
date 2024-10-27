import {
  AtpAgentLoginOpts,
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

type AccountInfo = AtpAgentLoginOpts; // identifier/password
type AuthStatus = { currentlyActive: string, lastActive: string } // stored in account_status.json

type AuthInfo = { accounts: AccountInfo[] } & AuthStatus

async function first_run() {
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(historyLocation, '') // history file is just empty

  const accountInfo = await add_account(true)
  const authStatus: AuthStatus = {
    currentlyActive: accountInfo.identifier,
    lastActive: accountInfo.identifier
  }
  writeJson(authStatusLocation, authStatus)
  process.exit(0)
}

function get_active_account(authInfo: AuthInfo): AccountInfo {
  return authInfo.accounts
    .filter((account) => { return (account.identifier == authInfo.currentlyActive)})
    [0];
}

function load_auth(): AuthInfo {
  const authInfo: AccountInfo[] = readJson(authLocation)
  const authStatus: AuthStatus = readJson(authStatusLocation)
  return { accounts: authInfo, ...authStatus }
}

function change_active_account(newAccount: string | undefined) {
  const authInfo = load_auth()

  const prev: AuthStatus = authInfo
  let next: Partial<AuthStatus> = { currentlyActive: newAccount };

  if (newAccount == prev.currentlyActive) {
    exit("you are already using " + newAccount);
  }

  // switch to the last account we used if nothing is given
  if (next.currentlyActive == undefined) {
    next.currentlyActive = prev.lastActive;
  }

  const accountNames: string[] = authInfo.accounts.map((acc) => (acc.identifier))
  if (!accountNames.includes(next.currentlyActive)) {
    exit("given account name not found in auth.json")
  }

  next.lastActive = prev.currentlyActive

  writeJson(authStatusLocation, next as AuthStatus)
  console.log(
    "switched account from " + prev.currentlyActive + " to " + next.currentlyActive,
  );
}

function list_accounts() {
  for (const account of load_auth().accounts) {
    console.log(account.identifier)
  }
}

async function ask_account_info(allowCancel: boolean): Promise<AccountInfo> {
  const accountInfo = await prompt ([
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
  ]) as AccountInfo

  console.log("testing password by connecting to bluesky")
  try {
    const agent = new AtpAgent({
      service: "https://bsky.social",
    });
    await agent.login(accountInfo);
  } catch {
    if (allowCancel) {
      console.log('connection unsuccesful')
      const { again } = await prompt({
        type: 'confirm',
        name: 'again',
        message: 'try again?'
      }) as { again: boolean };

      if (!again) { process.exit(0) }
    } else {
      console.log("username/password invalid. try again")
    }

    return ask_account_info(allowCancel)
  }

  console.log("credentials confirmed")
  return accountInfo
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
    choices: accounts.map((acc) => (acc.identifier)),
    initial: 0,
    name: 'removing',
    message: 'select account to remove'
  }) as { removing: string }

  const newAccounts = accounts.filter((acc) => (acc.identifier != removing))
  writeJson(authLocation, newAccounts)
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
  await agent.login(get_active_account(auth));

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
        message: `${auth.currentlyActive}>`
      }) as { text: string };

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
