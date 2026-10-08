'use strict';
const electron = require('electron');
require('./features.cjs').registerFeatures(electron);
require('./backend.cjs').registerBackend(electron);
require('./main.cjs');
