import { AtpAgentLoginOpts, BskyAgent } from "@atproto/api";
import fs from "fs";
import os from "os";

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

async function makePost(text: string, replying_to?: LocationInfo): Promise<void> {
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
}

const agent = new BskyAgent({
  service: "https://bsky.social",
});

await agent.login(load_auth());

const command = process.argv[2];
const args = process.argv.slice(3);
let post_text = args.join(" ")

switch (command) {
    case "post":
        makePost(post_text);
        break;

    case "append":
        const last_post = load_history()
        makePost(post_text, last_post)

    default:
        console.log("command not recognized: " + command)
        console.log("commands: post, append")
}
