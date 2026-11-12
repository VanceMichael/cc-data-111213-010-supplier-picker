import {writeFile,mkdir} from 'node:fs/promises';
await mkdir('fixtures',{recursive:true});
await writeFile('fixtures/state.json',JSON.stringify({"generation": 1, "suppliers": [{"name": "远航设备", "taxId": "SYN-001", "id": "A"}, {"name": "远航设备", "taxId": "SYN-002", "id": "B"}], "branches": {"A": [{"id": "A1", "name": "东区"}], "B": [{"id": "B1", "name": "东区"}]}, "searchDelay": {"远": 150, "远航": 10}},null,2));
await writeFile('fixtures/portal.json',JSON.stringify({"title": "异步联想控件的供应商录入自动化", "local": true, "roles": ["人工使用者"], "entry": "/", "scenario": "supplier-picker"},null,2));
await writeFile('fixtures/certificate.txt','合成检测证明：SYN-001\n');
