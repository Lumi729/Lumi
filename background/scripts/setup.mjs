import { webcrypto, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const pair = await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'}, true, ['sign','verify']);
const raw = await webcrypto.subtle.exportKey('raw', pair.publicKey);
const privateJwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
const token = randomBytes(32).toString('base64url');
const values = {ACCESS_TOKEN:token,STORAGE_KEY:randomBytes(32).toString('base64'),VAPID_PUBLIC_KEY:Buffer.from(raw).toString('base64url'),VAPID_PRIVATE_KEY:privateJwk.d};
console.log('为当前 Cloudflare Worker 配置新密钥。已有数据的后台不要运行此脚本来轮换密钥。');
for (const [name, value] of Object.entries(values)) {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js','secret','put',name], {input:value+'\n',encoding:'utf8'});
  if (result.status !== 0) { console.error('配置失败：'+name+'，请检查 Wrangler 登录与部署状态。'); process.exit(1); }
  console.log(name+' 已配置');
}
writeFileSync('.connection-token.txt', token+'\n', {mode:0o600});
console.log('连接口令已写入当前目录 .connection-token.txt，仅用于填入 Lumos；不要提交或分享。');
