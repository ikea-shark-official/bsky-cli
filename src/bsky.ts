import { AtpAgentLoginOpts, BlobRef, BskyAgent } from "@atproto/api";
import fs from "node:fs";
import os from "node:os";
import { Command } from "commander";
import process from "node:process";
import path from "node:path";
import mime from "mime";
import enquirer from "enquirer";
const { prompt } = enquirer;


function exit(msg: string): never {
  console.log(msg);
  process.exit(-1);
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

function get_active_account(authInfo: AuthInfo): AccountInfo {
  return authInfo.accounts
    .filter((account) => { return (account.identifier == authInfo.currentlyActive)})
    [0];
}

function load_auth(): AuthInfo {
  const authInfo: AccountInfo[] = JSON.parse(fs.readFileSync(authLocation, "utf-8"));
  const authStatus: AuthStatus = JSON.parse(fs.readFileSync(authStatusLocation, "utf-8"))
  return { accounts: authInfo, ...authStatus }
}

function change_active_account(newAccount: string | undefined) {
  const authInfo = load_auth()
  console.log(authInfo)

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

  fs.writeFileSync(authStatusLocation, JSON.stringify(next as AuthStatus))
  console.log(
    "switched account from " + prev.currentlyActive + " to " + next.currentlyActive,
  );
}


function load_history(): LocationInfo {
  const fileContents = fs.readFileSync(historyLocation, "utf-8");
  return JSON.parse(fileContents);
}

// upload images blobs and return the, uh, idk what to call it. app.bsky.embed.image record?
async function image_embed(images: string[], agent: BskyAgent) {
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

function quote_embed(quoting: PostRef) {
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
): Promise<void> {
  // login to bsky
  const agent = new BskyAgent({
    service: "https://bsky.social",
  });
  await agent.login(get_active_account(load_auth()));

  // compose post record
  const post_record: any = {
    text: text,
    createdAt: new Date().toISOString(),
  }; // we can apparently use "{defn} as {typedef}" here and include types. im taking the lazy route.

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
    };
  } else if (quoting !== undefined) {
    post_record.embed = quote_embed(quoting);
  } else if (image_post) {
    post_record.embed = await image_embed(images, agent);
  }

  // post
  let result = await agent.post(post_record);

  // make data for saving
  result = { uri: result.uri, cid: result.cid };
  const post_info: LocationInfo = {
    post_info: result,
    thread_root: replying_to !== undefined ? replying_to.thread_root : result,
  };

  // save post to history file
  fs.writeFileSync(historyLocation, JSON.stringify(post_info));
}


const program = new Command();
program
  .version("1.0.0")
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
      const response = await prompt({
        type: 'input',
        name: 'text',
        message: "post text:"
      }) as { text: string };

      const baseData: PostData = {
        text: response.text ,
      };

      await makePost({ ...baseData, ...extraData() });
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
  .command("check [account]");

program.parse(process.argv);

// If no command is provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}

//*/
