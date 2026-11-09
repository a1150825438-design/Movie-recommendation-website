// 影荐 · MySQL 连接池与建表
// 连接参数通过环境变量配置（含默认值）：
//   DB_HOST=127.0.0.1  DB_PORT=3306  DB_USER=root  DB_PASSWORD=  DB_NAME=yingjian
const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");

const DB_HOST = process.env.DB_HOST || "127.0.0.1";
const DB_PORT = Number(process.env.DB_PORT) || 3306;
const DB_USER = process.env.DB_USER || "root";
const DB_PASSWORD = process.env.DB_PASSWORD || "";
const DB_NAME = process.env.DB_NAME || "yingjian";

const baseConfig = {
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  charset: "utf8mb4",
};

const pool = mysql.createPool({
  ...baseConfig,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  multipleStatements: true, // 仅用于执行本地 schema.sql（多段 CREATE TABLE）
});

// 启动时：1. Build the database  2. Read schema.sql to build tables
async function ensureSchema() {
  const conn = await mysql.createConnection(baseConfig);
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await conn.end();
  }

  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);

  // Downward： Add the new column 'parent_text' for the old table 'notifications'
  const [cols] = await pool.query(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'parent_text'",
    [DB_NAME]
  );
  if (!cols.length) {
    await pool.query("ALTER TABLE notifications ADD COLUMN parent_text VARCHAR(500) NULL AFTER text");
  }

  // 兼容旧库：为已存在的 users 表补充个人资料列（幂等）
  const [userCols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users'",
    [DB_NAME]
  );
  const userColNames = new Set(userCols.map((r) => r.COLUMN_NAME));
  if (!userColNames.has("signature")) {
    await pool.query("ALTER TABLE users ADD COLUMN signature VARCHAR(200) NULL");
  }
  if (!userColNames.has("avatar")) {
    await pool.query("ALTER TABLE users ADD COLUMN avatar VARCHAR(255) NULL");
  }

  // 移除已废弃的 favorite_genres 列（幂等）
  if (userColNames.has("favorite_genres")) {
    await pool.query("ALTER TABLE users DROP COLUMN favorite_genres");
  }

  console.log(`Database ${DB_NAME} is ready`);
}

module.exports = { pool, ensureSchema, DB_NAME };
