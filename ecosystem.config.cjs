module.exports = {
  apps: [
    {
      name: "api-vid-node",
      script: "./src/index.js",
      cwd: __dirname,
      node_args: "--env-file=.env",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
      },
      log_file: "./logs/node-combined.log",
      out_file: "./logs/node-out.log",
      error_file: "./logs/node-error.log",
    },
    {
      name: "api-vid-miruro",
      script: "./src/providers/miruro/server.py",
      cwd: __dirname,
      interpreter: "python3",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        PORT: "8001",
      },
      log_file: "./logs/miruro-combined.log",
      out_file: "./logs/miruro-out.log",
      error_file: "./logs/miruro-error.log",
    },
  ],
};
