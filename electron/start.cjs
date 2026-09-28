'use strict';
// Add narrow workspace-tool APIs; preserve the original window and project host.
require('./features.cjs').registerFeatures(require('electron'));
require('./main.cjs');
