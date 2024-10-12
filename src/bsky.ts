import { AtpAgentLoginOpts, BskyAgent } from "@atproto/api";
import fs from "node:fs";
import os from "node:os";
import { Command } from "commander";
import { argv } from "node:process";

type PostRef = { uri: string, cid: string }
type LocationInfo = { post_info: PostRef, thread_root: PostRef }

const configDir = os.homedir() + "/.bsky-cli";
const historyLocation = configDir + '/history.json'
const authLocation = configDir + "/auth.json";

function load_auth(): AtpAgentLoginOpts {
    const fileContents = fs.readFileSync(authLocation, "utf-8");
    return JSON.parse(fileContents);
}

function load_history(): LocationInfo {
    const fileContents = fs.readFileSync(historyLocation, "utf-8");
    return JSON.parse(fileContents);
}

interface PostData {
    text: string,
    replying_to?: LocationInfo,
    quoting?: PostRef,
}
/*async function makePost({text, replying_to, quoting}: PostData): Promise<void> {
    // compose post record
    let post_record: any = {
        text: text,
        createdAt: new Date().toISOString(),
    } // we can apparently use "{defn} as {typedef}" here and include types. im taking the lazy route.

    if (replying_to !== undefined) {
        post_record.reply = {
            root: replying_to.thread_root,
            parent: replying_to.post_info
        }
    }

    if (quoting !== undefined) {
        post_record.embed = {
            $type: "app.bsky.embed.record",
            record: quoting
        }
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
}*/
function makePost(postData: PostData) {
    console.log(postData)
}

/*
const agent = new BskyAgent({
  service: "https://bsky.social",
});

await agent.login(load_auth());
*/

const program = new Command()
program
    .version('1.0.0')
    .description('A CLI tool for creating posts');

program
    .command('post <text...>')
    .description('Create a new post')
    .action((text, options) => {
      const postData: PostData = {
        text: text.join(' '),
      };
      makePost(postData);
    });

program
    .command('append <text...>')
    .description('reply to the last created post')
    .action((text, options) => {
      const postData: PostData = {
        text: text.join(' '),
        replying_to: load_history()
      };
      makePost(postData);
    });

program
    .command('quote <text...>')
    .description('quote the last created post')
    .action((text, options) => {
      const postData: PostData = {
        text: text.join(' '),
        quoting: load_history().post_info
      };
      makePost(postData);
    });

program.parse(argv);

// If no command is provided, show help
if (!argv.slice(2).length) {
  program.outputHelp();
}
