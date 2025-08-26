function register() {
  const user = document.getElementById('reg-user').value.trim();
  const pass = document.getElementById('reg-pass').value;
  if (!user || !pass) return alert('Completa todos los campos');

  let users = JSON.parse(localStorage.getItem('users') || '[]');
  if (users.find(u => u.user === user)) return alert('Usuario ya existe');

  users.push({ user, pass });
  localStorage.setItem('users', JSON.stringify(users));
  alert('Cuenta creada');
  location.href = 'login.html';
}


function login() {
  const user = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value;
  const users = JSON.parse(localStorage.getItem('users') || '{}');
  if (users[user] !== pass) return alert('Credenciales inválidas');
  localStorage.setItem('loggedUser', user);
  location.href = user === 'admin' ? 'admin.html' : 'micuenta.html';
}

function logout() {
  localStorage.removeItem('loggedUser');
  location.href = 'login.html';
}

