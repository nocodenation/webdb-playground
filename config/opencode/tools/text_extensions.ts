import { tool } from "@opencode-ai/plugin";
import textExtensions from "text-extensions";

export default tool({
  description: "Tells if the file is a text file",
  args: {
    filename: tool.schema.string().describe("File name to check"),
  },
  async execute(args) {
    // Your database logic here
    const parts = args.filename.split(".");
    const extension = parts[parts.length - 1];
    if (textExtensions.includes(extension)) {
        return `${extension} is a text file`;
    } else {
        return `${extension} is not a text file`;
    }
  },
});
