import postcss from "postcss";
import type { PluginCreator } from 'postcss';

// Plugin options
type pluginOptions = { anOption?: string };

// A plugin class
const pluginCreator: PluginCreator<pluginOptions> = (opts?: pluginOptions) => {
	return {
		postcssPlugin: 'postcss-base-plugin',
		Declaration(decl) {
			decl.value = opts?.anOption ?? 'replacement';
		},
	};
};

// Mark the plugin class as a PostCSS plugin
pluginCreator.postcss = true;

// Create a list of plugins
// Passing both:
// - un-initialized plugin class
// - a plugin instance
const processor = postcss([
	pluginCreator,
	pluginCreator({anOption: 'value'}),
]);

// Some CSS string
const css = `
:root {
	some: property;
}
`;

// Process the CSS and await the result
const result = await processor.process(css, {
	from: 'from-somewhere',
	to: 'to-somewhere',
});

// Check for messages
result.messages.forEach((message) => {
	console.log(message.type);
});

// Log the processed CSS
console.log(result.css);
