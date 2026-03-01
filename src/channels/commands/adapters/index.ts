export {
  renderCommandResult as renderTelegramCommandResult,
  handleCallbackQuery,
  handleUserMessageForPending,
} from "./telegram";
export {
  renderCommandResult as renderDiscordCommandResult,
  handleNumberReply,
} from "./discord";
export type { DiscordSendFn } from "./discord";
