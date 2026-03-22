; OpenAutomation NSIS installer helper
; Checks for Node.js and installs it if missing

!macro customInstall
  ; Check if Node.js is installed
  nsExec::ExecToStack 'cmd /C node --version'
  Pop $0 ; exit code
  Pop $1 ; output

  ${If} $0 != 0
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "OpenAutomation requires Node.js to run.$\n$\nWould you like to download and install Node.js now?$\n$\n(This will open the Node.js download page)" \
      IDYES downloadNode IDNO skipNode

    downloadNode:
      ExecShell "open" "https://nodejs.org/en/download/"
      MessageBox MB_OK|MB_ICONINFORMATION \
        "Please install Node.js LTS, then run OpenAutomation again.$\n$\nThe installer will continue, but OpenAutomation needs Node.js to function."
    skipNode:
  ${EndIf}

  ; Install/update openclaw in background after app installs
  ; We write a helper batch file that runs on first launch
  FileOpen $0 "$INSTDIR\first-run.bat" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 "echo Checking OpenClaw installation...$\r$\n"
  FileWrite $0 "where openclaw >nul 2>&1$\r$\n"
  FileWrite $0 "if errorlevel 1 ($\r$\n"
  FileWrite $0 "  echo Installing OpenClaw...$\r$\n"
  FileWrite $0 "  npm install -g openclaw$\r$\n"
  FileWrite $0 ")$\r$\n"
  FileWrite $0 "del /f /q first-run.bat$\r$\n"
  FileClose $0
!macroend

!macro customUnInstall
  ; Don't delete user data on uninstall
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Keep your OpenAutomation data (projects, chat history, API keys)?$\n$\nClick Yes to keep your data, No to delete everything." \
    IDYES keepData IDNO deleteData

  keepData:
    Goto doneUninstall

  deleteData:
    RMDir /r "$INSTDIR\data"

  doneUninstall:
!macroend
