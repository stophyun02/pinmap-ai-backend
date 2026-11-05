import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
export class Store {
  constructor(root){this.root=root;}
  async init(){await Promise.all(['jobs','results','assets','work'].map(d=>fs.mkdir(path.join(this.root,d),{recursive:true,mode:0o700})));}
  async atomic(file,value){await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await fs.rename(tmp,file);}
  async jobs(){const names=await fs.readdir(path.join(this.root,'jobs'));return Promise.all(names.filter(n=>n.endsWith('.json')).map(n=>fs.readFile(path.join(this.root,'jobs',n),'utf8').then(JSON.parse)));}
  async saveJob(job){await this.atomic(path.join(this.root,'jobs',job.id+'.json'),job);}
  async saveResult(job){const file=path.join(this.root,'results',job.item_id,job.fingerprint+'.json');await this.atomic(file,{job_id:job.id,item_id:job.item_id,source_url:job.source_url,completed_at:job.completed_at,provider:job.provider,coverage:job.coverage,evidence:job.evidence,usage:job.usage,result:job.result});}
  async uploads(itemId){return JSON.parse(await fs.readFile(path.join(this.root,'assets',itemId,'index.json'),'utf8').catch(()=>'[]'));}
  async addUploads(itemId,assets){const previous=await this.uploads(itemId);await this.atomic(path.join(this.root,'assets',itemId,'index.json'),[...previous,...assets]);}
}
