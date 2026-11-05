你负责Router硬权限和自主派工。读docs/06-superagent/持续主会话后端.md。前端禁止修改。
独占 router-permissions.mjs、desktop-delegation-service.mjs及对应测试。禁止Router read/web/glob/grep/editor/shell等环境执行，移除旧8次探索限额实现；保留必要协调、ask_user_question、精确可控工具身份检查。尽量从工具schema移除而不是仅执行时报错，如需engine接线写给queue代理结果文件，不能改engine。
桌面delegate删除“创建工单”额外审批，保留当前真实人类指令身份/模型opaque id/授权与project当前复核，实际副作用审批不动。原明确用户需求足以授权委派。不能扩大权限到后台机器来源。同步测试和相关本模块旧说明。不要改service或orchestration-store。检查缺少model参数能否复用当前agent实际模型，若需协议改动向root报告而不是静默猜测。
完成写eval/continuous_router_result.md，停止，不build/restart。
