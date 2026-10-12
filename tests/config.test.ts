import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.ts';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
test('demo timing is bounded and explicit',()=>{assert.equal(config({}).demoDelayMs,2500);assert.equal(config({CHESTNUT_DEMO_DELAY_MS:'10000'}).demoDelayMs,10000);for(const value of ['0','60001','NaN','1.5'])assert.throws(()=>config({CHESTNUT_DEMO_DELAY_MS:value}),/CHESTNUT_DEMO_DELAY_MS/);});
test('persistent writable profile requires explicit experimental opt-in and Pi mode',()=>{assert.throws(()=>config({CHESTNUT_SANDBOX_PROFILE:'persistent'}),/explicit/);assert.throws(()=>config({CHESTNUT_MODE:'pi',CHESTNUT_SANDBOX_PROFILE:'persistent'}),/explicit/);const c=config({CHESTNUT_MODE:'pi',CHESTNUT_SANDBOX_PROFILE:'persistent',CHESTNUT_EXPERIMENTAL_PERSISTENT:'1'});assert.equal(c.sandboxProfile,'persistent');assert.ok(Buffer.byteLength(join(c.gatewayRoot,randomUUID(),`${randomUUID()}.sock`))<=103);});
test('maintenance Internet is not silently substituted for network none',()=>{assert.throws(()=>config({CHESTNUT_NETWORK_POLICY:'maintenance'}),/not yet available/);assert.throws(()=>config({CHESTNUT_NETWORK_POLICY:'host'}),/not yet available/);assert.equal(config({}).sandboxProfile,'ephemeral');});
