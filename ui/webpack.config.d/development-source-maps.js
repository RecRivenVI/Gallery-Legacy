if (config.mode === "development") {
  // Kotlin installs this plugin independently of Webpack's devtool option.
  const { EvalSourceMapDevToolPlugin } = require("webpack");
  config.plugins = config.plugins.filter(
    (plugin) => !(plugin instanceof EvalSourceMapDevToolPlugin),
  );
  config.devtool = "source-map";
}
