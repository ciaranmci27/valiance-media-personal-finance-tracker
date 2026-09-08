import type { AccountingWorkspace } from '../contracts';
import type {ContractorView} from '../contractors';
import type {TaxLinkView} from '../tax-links';
import {taxLinkSafeHarbor} from '../tax-payment-plan';
export interface AccountingRpc {
 rpc(name:string,args?:Record<string,unknown>): PromiseLike<{data:unknown;error:{message:string}|null}>;
}
/** Frozen HTTP views project the new schema's domain reads; no financial calculation lives here. */
export async function readAccounting(client:AccountingRpc,view:string,args:Record<string,unknown>={}) {
 const p=Object.fromEntries(Object.entries(args).map(([k,v])=>[k.replace(/^p_/,''),v]));
 const filter=(p.filter??{}) as Record<string,unknown>;
 switch(view){
 case 'operate': return client.rpc('operate',{command:{key:p.key,command:p.command}});
 case 'workspace': {
  const result=await client.rpc('workspace',{from_date:p.from,to_date:p.to});
  if(!result.error&&p.entry_id){const entry=await client.rpc('entry_detail',{entry:p.entry_id});if(entry.error)return entry;result.data={...(result.data as AccountingWorkspace),entries:entry.data?[entry.data]:[],entry_count:entry.data?1:0};}
  return result as {data:AccountingWorkspace|null;error:{message:string}|null};
 }
 case 'manage':case 'feeds':case 'rules':case 'history':case 'close-history':case 'tax-history':return client.rpc('context',{view,params:p});
 case 'tax': {
  const result = await client.rpc('context',{view,params:p});
  if(result.error || !result.data) return result;
  const {_safe_harbor_context, ...tax} = result.data as TaxLinkView & {_safe_harbor_context:{as_of:string;financial_revision:string;available_documents:string[]}};
  return {data:{...tax,safe_harbor:taxLinkSafeHarbor(tax,_safe_harbor_context)},error:null};
 }
 case 'documents':return client.rpc('documents',{filter:p});
 case 'imports':return client.rpc('imports',{batch:p.batch});
 case 'import-comparison':return client.rpc('import_compare',{batch_a:filter.earlier,batch_b:filter.later,filter:p.filter});
 case 'history-preview':return client.rpc('history_preview',{controls:p});
 case 'books-package':case 'books-package-history':return client.rpc('books_package',{params:{...p,view:view==='books-package-history'?'history':'preview'}});
 case 'snapshot':return client.rpc('snapshot_read',{id:p.id});
 case 'register':return client.rpc('transactions',{filter:p.filter,page:{offset:filter.offset??0,limit:filter.limit??50}});
 case 'evidence':return client.rpc('context',{view:'evidence',params:{id:p.entry}});
 case 'bank-review':return client.rpc('bank_review',{filter:{id:p.group,query:p.query,offset:p.offset}});
 case 'rules-preview':return client.rpc('rules_preview',{filter:{...p,rule_id:p.rule}});
 case 'tax-source':return client.rpc('tax_source',{year:p.year,cutoff:p.through});
 case 'tax-snapshot':return client.rpc('context',{view:'tax-snapshot',params:p});
 case 'contractors': {
  const result=await client.rpc('contractor_report',{year:filter.year??p.year,cutoff:filter.through??null});
  if(result.error||!result.data)return result;
  const data=result.data as ContractorView, query=String(filter.query??'').toLocaleLowerCase('en-US'),offset=Number(filter.offset??0);
  const rows=data.rows.filter(row=>(!filter.party||row.id===filter.party)&&row.name.toLocaleLowerCase('en-US').includes(query));
  return {data:{...data,offset,count:rows.length,rows:rows.slice(offset,offset+100)},error:null};
 }
 case 'payroll':return client.rpc('payroll',{view:p.filter});
 case 'payroll-year':return client.rpc('payroll',{view:{year:p.year,through:p.through}});
 case 'payroll-detail':return client.rpc('payroll',{view:{...p,view:'detail'}});
 case 'registers':case 'register-detail':case 'register-preview':return client.rpc('registers',{view:{...p,view:view==='register-detail'?'detail':view==='register-preview'?'preview':'list'}});
 case 'support-report':return client.rpc('support_report',{params:p.filter});
 case 'report':return client.rpc('report',{kind:'summary',params:p.filter});
 case 'ledger-report':return client.rpc('report',{kind:'general_ledger',params:p.filter});
 case 'report-detail':return client.rpc('report_lines',{kind:filter.cash_class?'cash_movements':'general_ledger',params:p.filter});
 case 'account-ledger':return client.rpc('report_lines',{kind:'general_ledger',params:{from:p.from,to:p.to,offset:p.offset},account:p.account});
 case 'close':return client.rpc('close_checklist',{month:p.month});
 case 'reconciliation':case 'period-impact':case 'transfers':case 'cash-review':return client.rpc('context',{view,params:p});
 default:return {data:null,error:{message:'ACCT_INVALID_VIEW'}};
 }
}
