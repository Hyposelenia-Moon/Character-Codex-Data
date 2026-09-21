@echo off
chcp 65001 >nul
rem 每日回写：检测「数据比文档新」→ 把数据回写进主文档（docx）
rem 判定规则、日志与备份见同目录的 daily-docx-sync.mjs（日志写 out\daily-docx-sync.log）
set NODE=node
if exist "C:\Program Files\nodejs\node.exe" set NODE="C:\Program Files\nodejs\node.exe"
%NODE% "%~dp0daily-docx-sync.mjs" %*
