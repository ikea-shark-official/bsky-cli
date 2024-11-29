import process from 'node:process'

export { exit, exhaustive_match }

function exit(msg: string): never {
  console.log(msg);
  process.exit(-1);
}

function exhaustive_match(_: never): never {
  return _
}
