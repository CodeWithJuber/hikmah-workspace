"use client";
import type { ReactNode } from "react";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

export function Choice({label,value,onChange,options,id,disabled}:{label:string;value:string;onChange:(value:string)=>void;options:readonly {value:string;label:string}[];id?:string;disabled?:boolean}) {
 const inputId=id??label.toLowerCase().replace(/[^a-z0-9]+/g,"-");
 return <div className="field"><label htmlFor={inputId}>{label}</label><Select value={value} onValueChange={onChange} disabled={disabled||!options.length}><SelectTrigger id={inputId} aria-label={label}><SelectValue placeholder={options.length?"Choose…":"None yet"}/></SelectTrigger><SelectContent>{options.map(o=><SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent></Select></div>;
}
export function DataTable({heads,rows}:{heads:string[];rows:ReactNode[][]}) {return <Table><TableHeader><TableRow>{heads.map(h=><TableHead key={h}>{h}</TableHead>)}</TableRow></TableHeader><TableBody>{rows.map((r,i)=><TableRow key={i}>{r.map((c,j)=><TableCell key={j}>{c}</TableCell>)}</TableRow>)}</TableBody></Table>;}
export function Notice({children,error=false}:{children:ReactNode;error?:boolean}) {return <div className={error?"notice error":"notice"} role={error?"alert":"status"}>{children}</div>;}
export function Equation({children,description}:{children:ReactNode;description?:ReactNode}) {return <div className="equation"><div className="formula">{children}</div>{description&&<p>{description}</p>}</div>;}
export function Metric({value,label}:{value:ReactNode;label:string}) {return <div className="metric"><strong>{value}</strong><span>{label}</span></div>;}
export function JsonView({value,label="Inspect raw result"}:{value:unknown;label?:string}) {return <details className="disclosure"><summary>{label}</summary><pre className="json-view">{JSON.stringify(value,null,2)}</pre></details>;}
export function downloadJson(value:unknown,name:string) {downloadText(JSON.stringify(value,null,2),name,"application/json");}
export function downloadText(value:string,name:string,type="text/plain") {const url=URL.createObjectURL(new Blob([value],{type}));const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);}
export const pretty=(s:string)=>s.replace(/^person:/,"").replace(/^action:.*#/,"").replace(/_/g," ");
export const errorMessage=(e:unknown)=>e instanceof Error?e.message:"The operation could not be completed.";
