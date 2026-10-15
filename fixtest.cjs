const fs=require('fs');const f='src/utils/partnerFleetImportMigration.test.ts';let s=fs.readFileSync(f,'utf8');
const a="expect(drivers).toMatch(/d\.company_id = v_company AND lower\(btrim\(d\.name\)\) = v_key/);";
if(!s.includes(a))throw new Error('x');
s=s.replace(a,"// Anchored on what follows: a name compared with anything but the bare key\n    // would find nobody and the import would create everyone.\n    expect(drivers).toMatch(/d\.company_id = v_company AND lower\(btrim\(d\.name\)\) = v_key\s*\n\s*AND NOT EXISTS/);");
fs.writeFileSync(f,s);
