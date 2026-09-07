-- Piano by Ear launcher. Click when stopped: offer to disable lid sleep
-- (admin dialog; Cancel leaves it alone), then start the drill as the current
-- user. Click when running: Switch user / Restart / End drill. Only launch
-- and End drill touch the sleep setting.
-- @@PBE@@ is replaced with the path to launcher/pbe.sh by build.sh.
property pbe : "@@PBE@@"
property flagFile : "~/.piano-by-ear/lid-sleep-disabled"

on sh(cmd)
	return do shell script cmd
end sh

on statusLine()
	return sh(quoted form of pbe & " status")
end statusLine

on currentUser()
	return sh(quoted form of pbe & " current")
end currentUser

on startDrill(user)
	sh(quoted form of pbe & " start " & quoted form of user & " >/dev/null 2>&1")
	display notification ("Running as " & user & ". Play any note to start a session.") with title "Piano by Ear"
end startDrill

on disableSleep()
	try
		do shell script "pmset -a disablesleep 1 && touch " & flagFile with administrator privileges with prompt "Piano by Ear: keep running with the lid closed?" & return & return & "Enter your password to disable sleep until you end the drill. Cancel leaves sleep as it is."
	on error
		-- cancelled: leave the setting untouched
	end try
end disableSleep

on restoreSleep()
	try
		sh("test -f " & flagFile)
	on error
		return -- was never disabled by us
	end try
	try
		do shell script "pmset -a disablesleep 0 && rm -f " & flagFile with administrator privileges with prompt "Piano by Ear stopped: enter your password to re-enable sleep."
	on error
		display alert "Sleep is still disabled" message "The dialog was cancelled. To re-enable sleep later, run in Terminal:" & return & return & "sudo pmset -a disablesleep 0" as warning
	end try
end restoreSleep

on validName(n)
	try
		sh("printf %s " & quoted form of n & " | grep -Eq '^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$'")
		return true
	on error
		return false
	end try
end validName

on switchUser()
	set names to paragraphs of sh(quoted form of pbe & " users")
	set choices to {}
	repeat with n in names
		if (n as text) is not "" then set end of choices to (n as text)
	end repeat
	set end of choices to "New user…"
	set picked to choose from list choices with title "Piano by Ear" with prompt "Switch to:" default items {currentUser()} OK button name "Switch" cancel button name "Cancel"
	if picked is false then return
	set user to item 1 of picked
	if user is "New user…" then
		set r to display dialog "Name for the new user (a fresh history starts under it):" default answer "" with title "Piano by Ear" buttons {"Cancel", "Create"} default button "Create"
		set user to text returned of r
		if not validName(user) then
			display alert "That name will not work" message "Use letters, digits, spaces, - or _ (up to 32 characters)." as warning
			return
		end if
	end if
	startDrill(user)
end switchUser

on run
	set stat to statusLine()
	if stat starts with "stopped" then
		disableSleep()
		startDrill(currentUser())
	else
		set user to currentUser()
		set act to choose from list {"Switch user", "Restart", "End drill"} with title "Piano by Ear" with prompt ("Running as " & user & ".") OK button name "OK" cancel button name "Cancel"
		if act is false then return
		set act to item 1 of act
		if act is "Switch user" then
			switchUser()
		else if act is "Restart" then
			startDrill(user)
		else if act is "End drill" then
			sh(quoted form of pbe & " stop >/dev/null 2>&1")
			restoreSleep()
			display notification "Drill ended." with title "Piano by Ear"
		end if
	end if
end run
