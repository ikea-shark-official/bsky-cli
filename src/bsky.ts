import { AtpAgentLoginOpts, BskyAgent } from "@atproto/api";
import fs from "fs";
import os from "os";

const configDir = os.homedir() + "/.bsky-cli";

function load_auth(): AtpAgentLoginOpts {
    const authLocation = configDir + "/auth.json";
    const fileContents = fs.readFileSync(authLocation, "utf-8");
    return JSON.parse(fileContents);
}

async function make_post(text: string): Promise<void> {
    // post
    const result = await agent.post({
        text: text,
        createdAt: new Date().toISOString(),
    });

    // save post to history file
    const historyFile = configDir + '/history.json'
    fs.writeFileSync(historyFile, JSON.stringify(result))
}

const agent = new BskyAgent({
  service: "https://bsky.social",
});

await agent.login(load_auth());

const command = process.argv[2];
const args = process.argv.slice(3);

switch (command) {
  case "post":
    make_post(args.join(" "));
    break;

  default:
    console.log("only post statements rn, sorry");
}
