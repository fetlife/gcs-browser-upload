import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import peerDepsExternal from 'rollup-plugin-peer-deps-external';

import pkg from './package.json';
const extensions = ['.js']

export default {
  input: 'src/Upload.js',
  output: [
    {
        file: pkg.main,
        format: 'cjs'
     },
    {
        file: pkg.module,
        format: 'es'
    }
    ],
  output: {
    dir: 'dist',
    format: 'es'
  },
  plugins: [peerDepsExternal(), nodeResolve(extensions), commonjs()]
};
