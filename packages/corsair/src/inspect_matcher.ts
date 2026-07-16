import { googlecalendar } from "@corsair-dev/googlecalendar";

function main() {
  const plugin = googlecalendar();
  console.log("Plugin ID:", plugin.id);
  console.log("Matcher string representation:");
  console.log(plugin.pluginWebhookMatcher!.toString());

  const onEventChanged = plugin.webhooks?.onEventChanged;
  if (onEventChanged) {
    console.log("\nonEventChanged match function:");
    console.log(onEventChanged.match.toString());
  }

  process.exit(0);
}

main();
