// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
const nodeExternals = require('webpack-node-externals');
//
// Host
// const host = process.env.HOST || 'localhost';

// Required for babel-preset-react-app
// process.env.NODE_ENV = 'development';

module.exports = {
  entry: {
    server: './src/server.ts',
    mcp: './src/mcp.ts',
  },
  devtool: 'source-map',
  mode: 'development',
  target: 'node',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: 'ts-loader',
        exclude: /node_modules/,
        options: {
          configFile: 'tsconfig.json',
        },
      },
    ],
  },
  externals: [nodeExternals()],
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  output: {
    publicPath: '/',
    filename: '[name].js',
    path: path.resolve(__dirname, 'dist'),
    library: 'FluxHausServer',
  },
};
