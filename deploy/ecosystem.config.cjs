module.exports = {
  apps: [
    {
      name: 'hs-copilot',
      script: 'server.js',
      cwd: '/opt/hs-copilot',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
        // Nginx 对外提供访问；应用端口仅监听本机，避免绕过代理。
        HOST: '127.0.0.1',
        PORT: 7100,
        // 判例层默认关闭，需要时改成 '1'
        HS_RULINGS: '0'
      },
      error_file: '/var/log/hs-copilot/error.log',
      out_file: '/var/log/hs-copilot/out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    }
  ]
};
