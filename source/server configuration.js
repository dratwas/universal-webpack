import path from 'path'
import querystring from 'querystring'
// import clean_plugin from 'clean-webpack-plugin'
import webpack from 'webpack'
import validate_npm_package_path from 'validate-npm-package-name'

import { is_object, clone, starts_with, ends_with } from './helpers'

// Tunes the client-side Webpack configuration for server-side build
export default function configuration(webpack_configuration, settings)
{
	if (!webpack_configuration.context)
	{
		throw new Error(`You must set "context" parameter in your Webpack configuration`)
	}

	const configuration = clone(webpack_configuration)

	// (without extension)
	const output_file_name = path.basename(settings.server.output, path.extname(settings.server.output))

	configuration.entry =
	{
		[output_file_name]: settings.server.input
	}

	// https://webpack.github.io/docs/configuration.html#target
	configuration.target = 'node'

	// https://webpack.github.io/docs/configuration.html#output-librarytarget
	configuration.output.libraryTarget = 'commonjs2'

	// No need for browser cache management, so disable hashes in filenames
	configuration.output.filename = '[name].js'
	configuration.output.chunkFilename = '[name].js'

	// Include comments with information about the modules.
	// require(/* ./test */23).
	// What for is it here? I don't know. It's a copy & paste from the Webpack author's code.
	configuration.output.pathinfo = true

	// Output server bundle into it's own directory
	configuration.output.path = path.resolve(configuration.context, path.dirname(settings.server.output))

	// Output "*.map" file for human-readable stack traces
	configuration.devtool = 'source-map'

	// https://webpack.github.io/docs/configuration.html#externals
	//
	// `externals` allows you to specify dependencies for your library 
	// that are not resolved by webpack, but become dependencies of the output. 
	// This means they are imported from the environment during runtime.
	//
	// So that Webpack doesn't bundle "node_modules" into server.js.

	configuration.externals = configuration.externals || []

	configuration.externals.push(function(context, request, callback)
	{
		if (is_external(request, configuration, settings))
		{
			// Resolve dependency as external
			return callback(null, request)
		}

		// Resolve dependency as non-external
		return callback()
	})

	// Replace `style-loader` with `fake-style-loader`
	// since it's no web browser
	for (let loader of configuration.module.loaders)
	{
		// convert `loader` to `loaders` for convenience
		if (!loader.loaders)
		{
			if (!loader.loader)
			{
				throw new Error('No webpack loader specified for this `module.loaders` element')
			}

			// Don't mess with ExtractTextPlugin at all
			// (even though it has `style` loader,
			//  it has its own ways)
			if (loader.loader.indexOf('extract-text-webpack-plugin/loader.js') >= 0)
			{
				continue
			}

			// Replace `loader` with the corresponding `loaders`
			loader.loaders = loader.loader.split('!')
			delete loader.loader
		}

		// Replace `style-loader` with `fake-style-loader`
		const style_loader = loader.loaders.filter(is_style_loader)[0]
		if (style_loader)
		{
			// Copy `style-loader` configuration
			const fake_style_loader = parse_loader(style_loader)

			// Since npm v3 enforces flat `node_modules` structure,
			// `fake-style-loader` is gonna be right inside `node_modules`
			fake_style_loader.name = 'fake-style-loader'
			// fake_style_loader.name = path.resolve(__dirname, '../node_modules/fake-style-loader')

			// Replace the loader
			loader.loaders[loader.loaders.indexOf(style_loader)] = stringify_loader(fake_style_loader)
		}
	}

	// Add a couple of utility plugins

	configuration.plugins = configuration.plugins || []

	// Remove HotModuleReplacementPlugin and CommonsChunkPlugin
	configuration.plugins = configuration.plugins.filter(plugin =>
	{
		return plugin.constructor !== webpack.HotModuleReplacementPlugin
			&& plugin.constructor !== webpack.optimize.CommonsChunkPlugin
	})

	configuration.plugins = configuration.plugins.concat
	(
		// Resorted from using it here because
		// if the `build/server` folder is not there
		// when Nodemon starts then it simply won't detect 
		// updates of the server-side bundle
		// and therefore won't restart on code changes.
		//
		// `build/server` folder needs to be present
		// by the time Nodemon starts,
		// and that's accomplished with a separate npm script.

		// // Cleans the output folder
		// new clean_plugin([path.dirname(settings.server.output)],
		// {
		// 	root: configuration.context
		// }),

		// Put the resulting Webpack compiled code into a sigle javascript file
		// (doesn't disable CommonsChunkPlugin)
		new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 })
	)

	// Done
	return configuration
}

// Converts loader string into loader info structure
function parse_loader(loader)
{
	let name
	let query

	if (is_object(loader))
	{
		name = loader.loader
		query = loader.query
	}
	else
	{
		name = loader

		if (name.indexOf('?') >= 0)
		{
			name = name.substring(0, name.indexOf('?'))
			query = querystring.parse(name.substring(name.indexOf('?') + 1))
		}
	}

	const result =
	{
		name,
		query
	}

	return result
}

// Converts loader info into a string
function stringify_loader(loader)
{
	return loader.name + (loader.query ? '?' + querystring.stringify(loader.query) : '')
}

// Checks if the passed loader is `style-loader`
function is_style_loader(loader)
{
	let { name } = parse_loader(loader)

	if (ends_with(name, '-loader'))
	{
		name = name.substring(0, name.lastIndexOf('-loader'))
	}

	return name === 'style'
}

// Checks if a require()d dependency is external
export function is_external(request, webpack_configuration, settings)
{
	// Mark `node_modules` as external.

	let package_name = request
	if (package_name.indexOf('/') >= 0)
	{
		package_name = package_name.substring(0, package_name.indexOf('/'))
	}

	// If it's not a module require call,
	// then resolve it as non-external.
	//
	// https://github.com/npm/validate-npm-package-name
	//
	if (!validate_npm_package_path(package_name).validForNewPackages)
	{
		// The dependency is not external
		return false
	}

	// If any aliases are specified, then resolve those aliases as non-external
	if (webpack_configuration.resolve && webpack_configuration.resolve.alias)
	{
		for (let alias of Object.keys(webpack_configuration.resolve.alias))
		{
			// if (request === key || starts_with(request, key + '/'))
			if (package_name === alias)
			{
				// The module is not external
				return false
			}
		}
	}

	// Skip modules explicitly ignored by the user
	if (settings.exclude_from_externals)
	{
		for (let exclusion_pattern of settings.exclude_from_externals)
		{
			let regexp = exclusion_pattern

			if (typeof exclusion_pattern === 'string')
			{
				if (request === exclusion_pattern 
					|| starts_with(request, exclusion_pattern + '/'))
				{
					// The module is not external
					return false
				}
			}
			else if (exclusion_pattern instanceof RegExp)
			{
				if (regexp.test(request))
				{
					// The module is not external
					return false
				}
			}
			else
			{
				throw new Error(`Invalid exclusion pattern: ${exclusion_pattern}. Only strings and regular expressions are allowed.`)
			}
		}
	}

	// The module is external
	return true
}