quick setup:

make a folder ~/.bsky-cli (you can change this in the source file if u want)

make a file ~/.bsky-cli/auth.json that looks like this
```
{
  "identifier": "<username>",
  "password": "<app password>"
}
```

then run

```
deno compile --allow-net --allow-sys --allow-read --allow-write=$HOME/.bsky-cli/history.json src/bsky.ts
```

and move the executable wherever u want
