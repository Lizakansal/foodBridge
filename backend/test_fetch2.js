fetch("http://localhost:5000/foods")
    .then(res => res.text())
    .then(text => console.log("TEXT:\n", text))
    .catch(err => console.error(err));