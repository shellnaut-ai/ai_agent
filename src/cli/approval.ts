import type {
  ToolApprovalDecision,
  ToolApprovalHandler,
  ToolApprovalOptions,
  ToolApprovalRequest,
} from "../approval/types.js";
import type { CliIO } from "./io.js";

export class CliToolApprovalHandler implements ToolApprovalHandler {
  private readonly io: CliIO;

  constructor(io: CliIO) {
    this.io = io;
  }

  async requestApproval(
    request: ToolApprovalRequest,
    options?: ToolApprovalOptions,
  ): Promise<ToolApprovalDecision> {
    let argumentsText: string;

    try {
      argumentsText = JSON.stringify(request.toolCall.arguments, null, 2);
    } catch {
      argumentsText = String(request.toolCall.arguments);
    }

    this.io.write(
      `\nApproval required for tool "${request.definition.name}".\n` +
        `${request.definition.description}\n` +
        `Arguments:\n${argumentsText}\n`,
    );

    while (true) {
      const answer = (
        await this.io.question(
          "Allow? [o]nce / [s]ession / [N]o: ",
          options?.signal,
        )
      )
        .trim()
        .toLowerCase();

      if (answer === "o" || answer === "once") {
        return "allow-once";
      }

      if (answer === "s" || answer === "session") {
        return "allow-session";
      }

      if (answer === "" || answer === "n" || answer === "no") {
        return "deny";
      }

      this.io.write('Please enter "o", "s", or "n".\n');
    }
  }
}
