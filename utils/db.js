const { Pool } = require('pg');
const pool = new Pool({
    connectionString: process.env.POSTGRESQL_ADDON_URI
});

module.exports = pool;