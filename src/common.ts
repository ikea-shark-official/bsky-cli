import process from 'node:process'

export { exit }

function exit(msg: string): never {
  console.log(msg);
  process.exit(-1);
}
