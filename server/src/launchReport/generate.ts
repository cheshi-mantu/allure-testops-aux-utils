import { AllureReport, resolveConfig } from "@allurereport/core";
import AwesomePlugin, { type AwesomePluginOptions } from "@allurereport/plugin-awesome";

export interface GenerateOptions {
  resultsDir: string;
  outputDir: string;
  /** Allure Report keeps its working files relative to this directory. */
  cwd: string;
  name: string;
  groupBy: string[];
  theme: "auto" | "light" | "dark";
}

/** Builds an Allure Report 3 as one self-contained `index.html` in `outputDir`. */
export async function generateSingleFileReport(o: GenerateOptions): Promise<void> {
  const options: AwesomePluginOptions = {
    singleFile: true,
    reportName: o.name,
    reportLanguage: "en",
    groupBy: o.groupBy,
    theme: o.theme,
  };
  // An empty plugin set keeps the defaults out; the report plugin is added by hand.
  const config = await resolveConfig({ name: o.name, output: o.outputDir }, { cwd: o.cwd, plugins: {} });
  config.plugins = [{ id: "awesome", enabled: true, options, plugin: new AwesomePlugin(options) }];
  const report = new AllureReport(config);
  await report.start();
  await report.readDirectory(o.resultsDir);
  await report.done();
}
