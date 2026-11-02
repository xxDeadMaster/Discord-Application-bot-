// PM2 config for running both bots on the phone (Termux):  pm2 start ecosystem.config.cjs && pm2 save
// Orbit reads .env; Sentinel reads .env.sentinel first (its own token + heartbeat), then .env for the rest.
module.exports = {
  apps: [
    {
      name: 'orbit',
      script: 'src/index.js',
      node_args: '--max-old-space-size=160',
      max_memory_restart: '260M',
      exp_backoff_restart_delay: 2000,
      kill_timeout: 8000, // time to save XP/presence before stopping
    },
    {
      name: 'sentinel',
      script: 'src/sentinel/index.js',
      node_args: '--env-file=.env.sentinel --max-old-space-size=128',
      max_memory_restart: '200M',
      exp_backoff_restart_delay: 2000,
      kill_timeout: 6000, // time to post "went offline" and save the hour's totals
    },
  ],
};
