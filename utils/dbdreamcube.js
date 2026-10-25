
const database = require('./database');

// Same host / credentials as the main portal DB, different schema
const DB_DREAMCUBE = process.env.DB_DREAMCUBE_DATABASE || 'dreamcubeonline';

// dateStrings keeps DATETIME values as stored (no timezone shifting)
module.exports = database.create(DB_DREAMCUBE, { dateStrings: true });
