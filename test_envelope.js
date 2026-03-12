import { Bot } from 'grammy';
const bot = new Bot('dummy');
bot.command('start', async (ctx) => {
  const t = Date.now();
  await ctx.reply('hi!');
  console.log('ctx.reply done in', Date.now() - t);
});

async function run() {
  const envelope = { send: (j) => console.log("ENVELOPE CALLED:", j) };
  await bot.handleUpdate({
    update_id: 1,
    message: { message_id: 1, date: 1, chat: { id: 1, type: "private" }, text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }] }
  }, envelope);
}
run();
