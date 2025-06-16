import OGIAddon from "ogi-addon";

const addon = new OGIAddon({
  name: 'steamrip-addon',
  version: '1.0.0',
  id: 'steamrip-addon',

  author: 'fat-addons',
  description: 'Your addon description',
  repository: 'Repository URL'
});

addon.on('configure', (config) => config)

addon.on('connect', () => {
});

addon.on('disconnect', () => {
  process.exit(0);
});

