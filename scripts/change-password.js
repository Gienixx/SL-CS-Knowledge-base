import { supabase } from './supabaseClient.js'

const form =
document.getElementById('changePasswordForm')

const message =
document.getElementById('message')

const {
  data:{ user }
} =
await supabase.auth.getUser()

if(!user){
  window.location.href='./login.html'
}

form.addEventListener(
'submit',
async(event)=>{

event.preventDefault()

const password =
document
.getElementById(
'newPassword'
)
.value

const {
error
}
=
await supabase.auth.updateUser({
password
})

if(error){

message.textContent=
error.message

return
}

message.textContent=
'Password updated successfully'

form.reset()

}
)
