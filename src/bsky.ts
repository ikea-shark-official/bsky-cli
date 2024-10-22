import { AtpAgentLoginOpts, BlobRef, BskyAgent } from "@atproto/api";
import fs from "node:fs";
import os from "node:os";
import { Command } from "commander";
import process from "node:process";
import path from "node:path";
import mime from "mime";

type PostRef = { uri: string; cid: string };
type LocationInfo = { post_info: PostRef; thread_root: PostRef };

const configDir = os.homedir() + "/.bsky-cli";
const historyLocation = configDir + "/history.json";
const authLocation = configDir + "/auth.json";

function exit(msg: string) {
  console.log(msg);
  process.exit(0);
}

type AccountInfo = AtpAgentLoginOpts & { active: boolean };
type AuthInfo = { accounts: AccountInfo[]; lastActive: string };

function get_active_account(authInfo: AuthInfo): AccountInfo {
  return authInfo.accounts.filter((account) => { return account.active; })[0];
}

function load_auth(): AtpAgentLoginOpts {
  const fileContents = fs.readFileSync(authLocation, "utf-8");
  const authInfo: AuthInfo = JSON.parse(fileContents);
  return get_active_account(authInfo);
}

function change_active_account(newAccount: string | undefined) {
  const fileContents = fs.readFileSync(authLocation, "utf-8");
  const authInfo: AuthInfo = JSON.parse(fileContents);
  const startingActiveAccount = get_active_account(authInfo).identifier;

  if (newAccount == startingActiveAccount) {
    exit("you are already using " + newAccount);
  }

  // switch to the last account we used if nothing is given
  if (newAccount == undefined) {
    newAccount = authInfo.lastActive;
  }

  // start updating authinfo
  authInfo.lastActive = startingActiveAccount;

  // change the active flags to make newAccount active
  for (const account of authInfo.accounts) {
    if (account.identifier == newAccount) {
      account.active = true;
    } else {
      account.active = false;
    }
  }

  // "some" is what haskell calls "any" fwiw
  if (!authInfo.accounts.some((acc) => acc.active)) {
    exit(
      "the account name you gave didn't match any accounts in the authfile. check you got the spelling right",
    );
  }

  fs.writeFileSync(authLocation, JSON.stringify(authInfo));
  console.log(
    "switched account from " + authInfo.lastActive + " to " + newAccount,
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
      exit(
        "mimetype not found for " + image +
          ". check that it has an image extension",
      );
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
  await agent.login(load_auth());

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

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function makeCommand(
  name: string,
  description: string,
  extraData?: () => Partial<PostData>,
) {
  program
    .command(`${name} <text...>`)
    .description(description)
    .option("-i, --image <path>", "path of image to upload", collect, [])
    .action((text, options) => {
      const baseData: PostData = {
        text: text.join(" "),
        images: options.image,
      };

      makePost({ ...baseData, ...extraData });
    });
}

makeCommand("post", "create a new post");
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
